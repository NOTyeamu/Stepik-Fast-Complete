using System;

class Program
{
    static void Main()
    {
       int a = int.Parse(Console.ReadLine());
        int b = int.Parse(Console.ReadLine());
        int max = a > b ? a : b;
        Console.WriteLine(max);
    }
}