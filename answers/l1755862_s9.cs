using System;

class Program
{
    static void Main()
    {
        int n = int.Parse(Console.ReadLine());
        int i = 0;
        
        while (i < n)
        {
            Console.Write("*");
            i++;
        }
    }
}