using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        
        while (number >= 10)
        {
            number /= 10;
        }
        
        Console.WriteLine(number);
    }
}