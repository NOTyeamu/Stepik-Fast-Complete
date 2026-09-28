using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        int count = 0;
        
        while (number > 0)
        {
            count++;
            number /= 10;
        }
        
        Console.WriteLine(count);
    }
}